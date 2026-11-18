# Issue search at one and ten times history

Measured 2026-11-18 on a Linux agent VM, candidate `33f4ab4f16`.
SQLite only, as agreed for this phase. No index or transcript search was added.

| Search | x1 hits | x1 median / p95 (ms) | x10 hits | x10 median / p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| No match | 0 | 35.5 / 37.7 | 0 | 196.4 / 201.9 |
| Specific title | 1 | 41.2 / 43.4 | 1 | 216.4 / 222.5 |
| Description substring | 11 | 42.1 / 43.0 | 111 | 230.4 / 240.4 |
| Unique brief token | 1 | 30.3 / 31.0 | 1 | 160.2 / 164.8 |
| Broad two-character title | 3,253 | 894.5 / 931.4 | 18,426 | 7433.8 / 8091.1 |

The x1 cell (`h1a1`) has 4,867 issues; x10 (`h10a1`) has 27,601 issues.
History grows tenfold while active work stays fixed, so the total issue count
grows 5.7-fold. All samples and exact queries are in
[issue-search-7089.json](issue-search-7089.json).

## Method

The driver is [issue-search.ts](../../scripts/server-data-bench/issue-search.ts).
It exports the existing two-axis corpus with seed 4443, installs it in an isolated
in-memory SQLite store through the normal repositories, preserves parent links
and supported dependencies, and supplies the issue report service with a human
viewer and the normal existence/read predicate. No live or private data is used.

The exported corpus has short descriptions and no briefs. Every issue therefore
gets the same synthetic brief prefix (90 repetitions of `Synthetic search brief. `,
about 2 KiB), followed by `unique-brief-token:<id>`. The brief query matches only
that field. Titles and descriptions are the corpus's original strings.

Each query has one untimed warm-up, followed by 11 sequential measured calls to
the existing `IssueReportsModule.searchNormalized`, the service behind
`trpc.issues.searchNormalized`. Times include filtering, viewer-scoped report
construction and normalization. They exclude fixture creation, the 150 ms client
debounce, transport and the loader's later record fetch. The p95 is the nearest
rank (the largest of 11 samples). These are warm process/database measurements,
not disk-cold or multi-user throughput measurements.

Reproduce on an authorized agent VM, from a committed checkout:

```sh
bun --conditions=@podium/source scripts/server-data-bench/issue-search.ts
```

## Recommendation for POD-5617

Prioritize the search index for ten-times history. Even selective title/body
queries take 160–230 ms median at x10, and a miss takes 196 ms. Including the
existing 150 ms debounce gives roughly 310–380 ms before transport and record
loading. The x1 selective calls take 30–42 ms, so device-first results remain
useful while the current scanning service runs.

An index alone will not make broad searches fast: `re` returns 18,426 records at
x10 and the full normalized answer takes 7.4 seconds median (8.1 seconds p95).
The server currently normalizes every hit and the loader requests every returned
ID. A bounded/paged response and bulk normalization need separate follow-up;
this measurement does not attribute the broad-query cost to the scan alone.

## Correctness evidence

The focused search safety check passed at `h1a1`, `h1a4`, `h10a1` and `h10a4`:
each answer equals its full-load control or is `LOADING`. The startup search
group now covers 25 questions, including phone links/Work and the additional web
target pickers. Policy and first-download states have zero wrong search answers.
Surface tests cover missing-device body matches, offline results and stale
responses; the collection test uses the real loader to install cached one-record
instances and preserve shared model identity. See
[startup-baseline.md](startup-baseline.md#device-first-search-pod-7089).


The four-cell safety evidence above is from the initial candidate. Final
validation remains open: the legacy all-history lazy comparison still exhausts
sixteen hydration rounds (POD-7110), and the lean gate's cache-input audit finds
the worklist typecheck key missing the web choice helper (POD-7109). The final
full typecheck and every static fence pass, including the refreshed interaction
census. The lean gate is **not green**. Archived palette server-hit eligibility
also needs preservation (POD-7111); the unrelated machine picker fixture remains
POD-7107. These are handed off explicitly under the coordinator's final-run limit.
