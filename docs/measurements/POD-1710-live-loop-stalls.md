
---

## A/B probe baseline (the number the fixes must beat)

Ambient live numbers are too noisy to grade a fix: `feedBootstrap.read` measured
p50 4698 ms on one server process and p50 1304 ms on the next, both at n=2.
`scripts/perf/pod1710-ab.sh` removes that variance — it drives a FIXED set of
search terms and reads the server's own timings back, so the same script run
before and after a deploy is comparable on the same box and DB.

Baseline, server at `ce497a45c`, 2026-08-04 19:42 (client-observed wall clock):

| search term | wall time |
|---|---|
| `a` | 12.509 s |
| `e` | 6.096 s |
| `in` | 6.170 s |
| `the` | 10.792 s |
| `po` | 14.406 s |
| `se` | 6.170 s |

Server-side for the same six calls: `conversations.search` n=6 **p50 5840 ms,
p95 13 914 ms**. `sessions.list` was 0.19–0.48 s across five calls.

**Every keystroke in the search box costs between six and fourteen seconds of
fully blocked event loop**, and this is reproducible on demand rather than
inferred from a tail.

Note: running this probe itself freezes the live server for ~60 s in total, so it
is a deliberate act, not something to leave on a loop.
