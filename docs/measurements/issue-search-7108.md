# Paged issue search at one and ten times history

Measured 2026-11-18 on one Linux agent VM, SQLite only, with the
[POD-7089 driver](../../scripts/server-data-bench/issue-search.ts) and its corpus
(seed 4443, 2 KiB synthetic briefs). Before is the base `700d683746`, which
returns every hit normalized. After is `dab24f03dd`, which returns one page of
50 hits and a cursor. Times are medians and p95s of 11 warm calls, in ms.

| Search | x1 hits | x1 before | x1 after | x10 hits | x10 before | x10 after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No match | 0 | 40.1 / 47.6 | 34.8 / 36.6 | 0 | 211.0 / 231.2 | 189.0 / 218.5 |
| Specific title | 1 | 39.5 / 42.1 | 38.1 / 39.4 | 1 | 230.7 / 265.5 | 207.0 / 217.4 |
| Description substring | 11 | 41.1 / 43.9 | 37.1 / 39.4 | 111 | 217.9 / 244.6 | 197.7 / 216.7 |
| Unique brief token | 1 | 28.5 / 29.5 | 28.0 / 28.5 | 1 | 158.5 / 191.3 | 150.9 / 153.6 |
| Broad two-character title (`re`) | 3,253 | 896.7 / 1126.8 | 30.1 / 37.2 | 18,426 | 6968.1 / 7329.5 | 139.4 / 171.9 |

The second page of `re` takes 28.9 / 29.6 ms at x1 and 161.8 / 168.9 ms at x10.
The second page of the x10 description search (111 hits) takes 191.9 / 203.1 ms.
All samples are in [issue-search-7108.json](issue-search-7108.json).

## What changed

`issues.searchNormalized` answers `{ hits, next }`. It takes `limit` (default 50,
at most 200) and `cursor`, the previous page's opaque `next`. The cursor holds
the last hit's ordering keys. SQL applies it as a keyset condition with
`LIMIT limit + 1`, so a page reads at most one row past itself. Only the page's
rows are normalized, with one label read for the page and no report joins. The
legacy `issues.search` (the CLI) is still unbounded.

The order is the existing `priority-seq` listing order: priority, number,
repository path, id. It already ends with the id, so it is total and needed no
new tie-break.

Searches that SQL cannot decide alone still read every row after the cursor
and cut in JavaScript: `status: ready` and `status: deferred` (deferral is
decided by `Date.parse`) and non-ASCII text (SQLite folds ASCII case only).
They still normalize only one page.

What remains at x10 is the text scan itself: a miss costs about 190 ms. That is
the index work in POD-5617.

## Parity

For every case, the driver checks that the first page equals the first 50 ids
of the unbounded search, in order, that `next` is present exactly when more
hits exist, and that the second page equals ids 51 to 100.
`listings.test.ts` walks every page at page sizes 1, 4 and 50 for eight filters,
as the server and as a member. The concatenated pages equal the unbounded
search. Each hit equals the old normalization, and SQL-decided searches never
read more than one row past the page.

## Client

The search loader installs only the page it received. It asks for the next
page only when a view reads with a larger `want` than the hits it holds. The
phone Work list does that at its scroll end, and the link-target sheet does it
as its window grows. Every other picker shows a few rows from the first page.
`issue-search.test.ts` checks that one page is installed and nothing more is
requested. It also checks that a larger window requests and installs exactly
the next page, and that a failed page is not retried in a loop.
