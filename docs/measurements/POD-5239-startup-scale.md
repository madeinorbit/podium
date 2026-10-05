# Startup time at scale

The first local fix removes a redundant tree traversal when a query value changes
without changing its ordering key. The work guard improves from 21 to 12 comparisons
at 1,024 entries and from 25 to 14 at 4,096 entries. One matched 4× startup pair
shows lower cold wall time and lower cold and warm CPU, while warm wall time rises.
These single samples on a loaded host establish the mechanism, not a reliable
latency estimate or a certified startup budget.

## Matched startup pair

| Runtime | Cold first row Paint | Cold main thread CPU | Warm first row Paint | Warm main thread CPU |
| --- | ---: | ---: | ---: | ---: |
| Before `b60c38e29e` | 9,565.8 ms | 7,865.8 ms | 6,371.4 ms | 5,189.6 ms |
| Path replacement `05ad4673b5` | 8,797.2 ms | 7,164.3 ms | 6,720.3 ms | 5,048.9 ms |
| Change | −8.0% | −8.9% | +5.5% | −2.7% |

Each runtime has one unprofiled cold context and its warm reload. Both consume
POD-5501's unchanged 4× corpus: 19,468 issues and 17,216 sessions, plus isolated
fixture controls. The full corpus reached IndexedDB before each reload. Cold means
fresh application storage; warm retains durable data and uses cursor resume.
HTTP cache is disabled by Playwright routing. Chromium 153 runs on flatblock at
1800×1000 with service workers blocked. The boundary is the first Chromium Paint
after an unobscured sidebar issue row appears and the boot splash disappears.
The first load average is 6.35 before and 10.56 after. The blocked service worker
warnings occur in both arms; neither has a React startup failure.

## Startup profile

One additional cold and warm pair profiles the before runtime. These samples do
not enter the timing table. Source maps attribute the samples before the same
first row Paint. Exclusive values partition sampled wall intervals; inclusive
stack values overlap and must not be added together.

| Source | Cold sampled self | Warm sampled self |
| --- | ---: | ---: |
| Ordered query results | 1,147.2 ms | 866.1 ms |
| Garbage collection | 1,109.2 ms | 829.5 ms |
| Relation index | 457.0 ms | 404.6 ms |
| MobX | 429.7 ms | 330.2 ms |
| Reader questions | 391.2 ms | 453.7 ms |
| Cold index | 372.9 ms | 301.7 ms |
| Session questions | 318.5 ms | 298.8 ms |
| Row source | 136.5 ms | 188.4 ms |

Ordered query results are the largest mapped application source. The tree's node
constructor and insertion paths dominate its frames. Scalar session indexes
repeatedly update bucket and revision values with the same sort key; removing
those entries first copies and rebalances an unnecessary second path. The fix
keeps immutable snapshots and forks, and still removes entries when their order
or predicate membership changes. It also updates bounded scalar metadata.

## Focused proof

On flatblock, the new guard fails on the old implementation at both sizes.
The candidate runs all 20 tests in `query-result.test.ts` and
`reader-question-bounds.test.ts` through `bun run test:file`. Coverage includes
ordering, ties, changed predicates, counts, witnesses, LOADING, closed demand,
immutable snapshots, fork isolation and bounded answers. This is focused evidence;
no full suite or lean gate was run.

The [raw before capture](POD-5239-startup-scale/before.json),
[path replacement capture](POD-5239-startup-scale/after-path.json),
[source attribution](POD-5239-startup-scale/attribution.json) and
[guard provenance](POD-5239-startup-scale/proof.json) retain the exact inputs,
SHAs, timings and limits. Raw traces and profiles remain in the issue-owned
`~/podium-test-5239` checkout on flatblock. The capture controller releases
`bench:flatblock` immediately after capture and stops only its recorded processes.

## Remaining work

Per-row persistent insertion still allocates a tree path for every initial index
entry. The coordinator cleared a bulk construction algorithm on October 5:
retain the same tree type and snapshot semantics, prove equivalence including
ties and ordering, and take one matched 4× pair after landing the first fix.
No server, sync, residency or operator runtime changes are included.
