# Startup time at scale

Three local fixes remove redundant tree traversals and per-entry persistent path
construction during startup. The largest observed CPU decrease is in scalar
session bootstrap: 8.39 to 7.23 seconds cold and 5.86 to 5.15 seconds warm. Armed
work guards and focused equivalence tests establish the mechanism. Each fix has
one matched 4× pair on a loaded host; these observations do not establish a
reliable latency estimate or a certified startup budget.

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

## Initial demanded roots

The second fix collects initial answers, sorts once, and builds the same immutable
tree with one node per entry. Predicate trees use the same algorithm. Subsequent
updates still use persistent paths. The focused guard fails on the prior code:
ordering reads fall from 7,172 to 1,020 at 256 entries and from 36,868 to 4,092 at
1,024 entries. All 23 query-result and reader-question tests pass, including bulk
versus incremental equivalence for empty, singleton, reversed and mixed inputs,
ordering ties and predicate counts.

| Runtime | Cold first row Paint | Cold main thread CPU | Warm first row Paint | Warm main thread CPU |
| --- | ---: | ---: | ---: | ---: |
| Before `51da487185` | 12,736.1 ms | 7,784.6 ms | 8,976.1 ms | 5,393.0 ms |
| Bulk demanded roots `b113ab1842` | 9,249.4 ms | 7,627.6 ms | 6,887.2 ms | 5,209.0 ms |
| Change | −27.4% | −2.0% | −23.3% | −3.4% |

This is another single matched pair under the same capture contract, after the
first fix landed. The first load average is 16.07 before and 6.86 after, rising
to 25.11 by the baseline's end. The wall-time decrease is confounded by host load;
these observations do not establish the size of the latency benefit.

The first candidate capture was rejected: Turbo replayed the baseline bundle
`Brp6zalX` for candidate `5f587ad108`, despite stamping the new source SHA. The
archived source map contained the old algorithm. Both client build tasks omitted
`packages/client-graph/package.json` and `packages/client-graph/src/**` from their
inputs. The repair adds those inputs. The existing build-input guard fails for
both clients with the omission and passes all six checks after the repair. A
normal build then misses the cache, produces bundle `DX3ZA-RN`, and maps the new
algorithm. Only that replacement capture enters the table; no cache bypass was
used.

The [bulk baseline](POD-5239-startup-scale/before-bulk.json),
[valid bulk capture](POD-5239-startup-scale/after-bulk.json),
[excluded stale capture](POD-5239-startup-scale/excluded-stale-bulk.json) and
[bulk guard provenance](POD-5239-startup-scale/proof-bulk.json) preserve this
distinction. Build and guard logs remain in the private remote checkout.

## Landing provenance

The first fix landed at `51da487185` after rebasing onto the coordinator branch.
Measurements name the pre-rebase candidates; later landings are not additional
timed runs. The bulk-root fix landed at `2a450299a5`, preserving POD-5240's web
build inputs and lazy-loading changes; its additional build-key repair adds
mobile inputs.

The blocking build boundary repair landed at `34af388548` before the scalar pair.
Its [report](POD-5582-startup-bundle.md) explains the coordinator's updated
always-pool startup contract, the explicit source boundary and unchanged byte
ceilings. Both build dependencies are closed. No server, sync, residency or
operator runtime changes are included.

## Scalar session bootstrap

Candidate `4750df3f36` accumulates unpublished session-index entries before
constructing the ordinary immutable trees. Initial relations are already final,
so seeding uses their collapse and ordering answers without replaying each row's
visibility update. Published edits still use the original persistent paths;
bootstrap maps and writer wrappers are released before publication.

The wiring guard spies persistent entry writes through the session module's
keyed-answer factory. It fails when the old cold-index seeding path is restored:
456 writes at 128 sessions and 1,776 at 512. The candidate records zero at both
sizes. These are the guard's counted writes, not a census of all allocations.
All 47 tests in six focused files pass, covering ordered answers, scalar bounds,
counts, witnesses, close facts, replacements, duplicate IDs, deletion, clock
rewind, collapse, reference winners and fork isolation. The [final proof ledger](POD-5239-startup-scale/proof-scalar.json)
names the candidate and the baseline file used to arm the guard. The earlier
[pre-reference proof](POD-5239-startup-scale/proof-scalar-initial.json) is retained
as background rather than final evidence.

| Runtime | Cold first row Paint | Cold main thread CPU | Warm first row Paint | Warm main thread CPU |
| --- | ---: | ---: | ---: | ---: |
| Before `34af388548` | 10,238.5 ms | 8,387.0 ms | 7,355.7 ms | 5,855.6 ms |
| Scalar bulk seeding `4750df3f36` | 8,635.3 ms | 7,235.0 ms | 6,267.8 ms | 5,150.6 ms |
| Change | −15.7% | −13.7% | −14.8% | −12.0% |

The first load average is 8.81 before and 5.48 after. The pair retains the same
4× input and capture contract as above; CPU and wall observations both decrease,
with host load still a confounder. Both normal production builds succeed. The
baseline bundle is `BtL9OZI_` and the candidate is `Cdrr-1iB`; the newest archived
source maps contain the keyed builder, scalar bulk seeding and cold-index wiring.
The [baseline capture](POD-5239-startup-scale/before-scalar.json),
[candidate capture](POD-5239-startup-scale/after-scalar.json) and
[bundle source checks](POD-5239-startup-scale/scalar-bundle-source.json) preserve
that provenance. The benchmark lease was released immediately after each pair.

## Limits

These changes remove a demonstrated local tree-construction hotspot. Bootstrap
still ingests the complete corpus and constructs its relation and scalar metadata;
that work continues to grow with total data. Sorting arbitrary initial inputs is
still O(n log n), while tree-node construction is linear. None of these results
proves a visible-row-only startup architecture or a target latency budget.

The timings cover web startup at 4× only. There is no new phone timing, principal
switch timing or retained-heap claim, and no full suite or lean gate was run.
Results from separate fix pairs must not be compounded: intervening pilot
landings and host load differ. Further loading or partial-bootstrap changes need
the operator's architecture decision through the coordinator.
