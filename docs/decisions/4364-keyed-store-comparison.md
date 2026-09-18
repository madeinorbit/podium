# Hand-written keyed store comparison

**Recommendation: drop the reactive-library requirement and proceed with a hand-written
keyed read model for the epic.** This proof does not justify adding MobX. The plain
arm matches every isolation assertion, stays competitive on latency (with the
exceptions below), uses less mounted heap, and removes most of the instrumented
mission/materialization remainder. Keep the existing D1 pins until the operator
accepts the decision; this change removes no dependency and migrates no consumer.

The complete arm is **130 physical lines**, including imports, comments, blanks,
cache policy, counters, lifecycle and React bindings (MobX: 76). Sharing and quiet
unmount were straightforward here: one lazy cell per summary, a Set of listeners,
and invalidation of the old/new membership buckets. No difficult disposal order
or computed-graph requirement emerged in this fixture. The cost is explicit
invalidation code: it must evolve with the inputs, and this proof is not a generic
replacement for automatic dependency discovery, batching, deletion handling or
production cache eviction.

D7 extends [D1](4321-reactive-pilot.md) to answer whether the epic needs a reactive
library at all. This is a proof-only comparison; no production consumer, default
path, or dependency pin changes. D1's MobX-versus-TanStack decision is unchanged.

The third arm is [keyed.tsx](../../packages/client-core/proofs/d1/keyed.tsx): plain
immutable row Maps, per-address subscriber sets, lazy shared issue summaries and
React's existing `useSyncExternalStore`. Derived cells retain their last snapshot
and mark it dirty on material row/membership changes. Both summary consumers read
one cell. Unmount removes listeners; unobserved updates do no summary or mission
work; explicit owner disposal clears maps, caches and subscriptions. Cells retain their last snapshot while the proof owner remains reachable; this is not a production eviction policy.

The group caches rollups by formal issue family using immutable issue/session
references, preserving the unchanged `missionRollup` function and its full group
inputs. Every issue mutation clears the family cache. Session reassignment changes
both families' inputs. Any `startedBySession`, dependency or dependent edge uses
a conservative whole-group cache key. Cyclic parent walks also fall back. This is
an explicit proof optimization, not a general reactive dependency graph or a
claim that all production mission topologies enjoy family isolation.

The indexed row materialization removes D1's repeated `sessions.filter` for each
issue. Nesting and sorting still run on every relevant group update. The operation
counters are the same wrapper counters as D1, not total JavaScript instructions:
index gathers, family-key comparisons and library internals are not included.
MobX could use the same indexing and family cache; any reduction here belongs to
the derivation design, not an inherent limit of MobX.

The comparison reuses D1's exact 4,867-issue / 4,304-session fixture, 200-issue
group, N=200/1,000 same/distinct cohorts, 20 unrelated/relevant timestamp deltas,
three growth/live/growth replacements, domain oracle and zero-isolation assertions.
The armed coarse control is unchanged. Additional oracle checks after each timed
delta (outside its timer), archived/presence changes, session reassignment after reparenting,
provenance introduction and each rescope exercise cache correctness. MobX receives
the same checks. Library-only lifecycle tests remain in D1 and are skipped in D7.

Run from the root:

```sh
bun scripts/test-heavy.ts -- bun packages/client-core/proofs/d1/validate-d7.ts
```

This one sequential lane runs scoped web/mobile typechecks, the two existing D1
proof files, one fresh Bun process per mounted-heap case, and the shared Vite/Expo
bundle builder for MobX and keyed only. It does not rerun TanStack, legacy adapter
tests or ordinary client builds: those paths and pins are unchanged.

Latency is shared-host action-to-settled-React time, not paint or device latency.
With 20 samples D1's p95 is the maximum; rescope p95 is the maximum of three.
Bootstrap is one sample per case. Heap uses three synchronous-GC samples in each
fresh process and excludes fixture/import allocations from its baseline. It
includes React and DOM allocation; post-disposal heap is not a leak estimate.
Mobile uses the existing unit renderer; Expo native bundles establish module
compatibility, not device performance.

Disable: omit `PODIUM_D1_PROOF=1`; ordinary unit runs skip the proof. Revert the
D7 commits to remove this arm and its runner while retaining D1's pins and record.
No production rollout or dependency removal is included in this deliverable.

## Measured results

[Raw measurements](../measurements/POD-4364-keyed-proof.json) retain all counters,
timing samples' distributions, heap samples and emitted bundle sizes. Results are
from the corrected final run; the initial run caught an added oracle-ordering
mistake in both arms. The replacement reassignment preserves D1's session order.
No failing or partial run contributes a number below.

Both arms, both platforms, both address cohorts:

| Per delta | MobX | Keyed |
| --- | ---: | ---: |
| Unrelated row reads / effects, N=200 and N=1,000 | 0 / 0 | 0 / 0 |
| Relevant same-address reads / effects | N / N | N / N |
| Relevant distinct-address reads / effects | 1 / 1 | 1 / 1 |
| Unrelated summary / group renders | 0 / 0 | 0 / 0 |
| Relevant shared summary evaluations (two consumers) | 1 | 1 |
| Relevant mission calls | 200 | 5 |
| Relevant group materialization session visits | 40,000 | 200 |
| Relevant total instrumented session visits (includes summary) | 40,001 | 201 |
| Relevant summary child visits | 4 | 4 |
| Relevant nesting / sort calls | 1 / 1 | 1 / 1 |

The **unchanged armed coarse control** produces 200/200 and 1,000/1,000 unrelated
reads/effects. Its zero-isolation assertion throws, as asserted by the passing
control test on each platform. Thus the isolation detector is demonstrably
sensitive. Unmount leaves keyed with zero subscribers; updating afterward does no
mission or summary work.

Family caching reduces mission calls **40×**; indexed materialization reduces the
explicit group session visits **200×**. It still does five mission calls, not zero,
and retains group nesting/sorting and linear index/cache-key gathering. No claim
is made about hidden domain/library operations or production worklist budgets.

### Wall time (milliseconds)

**Web**

| N / addresses | Bootstrap MobX / keyed | Relevant p95 MobX / keyed | Rescope p95 MobX / keyed |
| --- | ---: | ---: | ---: |
| 200 / same | 131.26 / 17.99 | 23.95 / 8.09 | 95.11 / 37.92 |
| 200 / distinct | 16.57 / 24.15 | 6.01 / 6.20 | 35.90 / 20.85 |
| 1000 / same | 49.22 / 16.35 | 72.24 / 27.64 | 35.95 / 19.03 |
| 1000 / distinct | 36.31 / 16.79 | 4.19 / 2.38 | 36.44 / 25.05 |

**Mobile unit renderer**

| N / addresses | Bootstrap MobX / keyed | Relevant p95 MobX / keyed | Rescope p95 MobX / keyed |
| --- | ---: | ---: | ---: |
| 200 / same | 148.13 / 19.39 | 66.58 / 14.93 | 82.37 / 17.71 |
| 200 / distinct | 74.03 / 24.84 | 18.88 / 18.59 | 72.99 / 30.06 |
| 1000 / same | 85.63 / 81.09 | 49.38 / 27.09 | 133.04 / 33.29 |
| 1000 / distinct | 106.31 / 61.71 | 10.60 / 8.47 | 79.05 / 35.84 |

Keyed is not uniformly faster: web N=200 distinct bootstrap is 24.15 ms versus
16.57 ms (1.46× slower), and relevant p95 is 6.20 versus 6.01 ms (1.03×).
All other measured bootstrap/relevant-p95/rescope-p95 cells favor keyed. This is
well within a reasonable tradeoff given equal isolation and lower heap/dependency
cost. Fixed MobX-first ordering, a single bootstrap sample, shared-host noise and
maximum-as-p95 mean these timings do not establish a stable speedup ratio. The
operation counts are the stronger finding.

### Mounted heap (fresh process, MiB)

| N / addresses | MobX | Keyed |
| --- | ---: | ---: |
| 200 / same | 8.87 | 5.13 |
| 200 / distinct | 8.98 | 5.27 |
| 1000 / same | 12.88 | 7.93 |
| 1000 / distinct | 13.69 | 8.59 |

Keyed retains approximately 37–42% less mounted heap across the four cases.

### Emitted bundle bytes

| Build | MobX bytes / gzip | Keyed bytes / gzip |
| --- | ---: | ---: |
| Vite isolated proof; React external | 274,522 / 64,849 | 207,202 / 47,713 |
| Vite library-only; React external | 68,741 / 18,160 | 0 / 20 |
| Expo web isolated entry; includes React | 835,343 / 205,900 | 773,650 / 189,996 |
| Expo ios isolated entry; includes React | 899,798 / 222,811 | 838,900 / 206,654 |
| Expo android isolated entry; includes React | 899,798 / 222,811 | 838,900 / 206,654 |

**Added library payload: zero bytes** for keyed, versus MobX's 68,741 emitted
bytes (18,160 gzip). The empty library entry produces a zero-byte file; gzip's
20-byte empty-stream envelope is recorded honestly but is not library code or an
application dependency. The hand-written implementation itself is not free:
its full proof emits 207,202 bytes including existing domain code, versus MobX's
274,522. Both externalize React. These standalone bundles are not a prediction
of incremental production chunk sizes. All six Expo web/iOS/Android entries built.

## Validation and next decision

Final specialized lane exited **0**: 18 scoped typecheck tasks, **9 web + 9 mobile
proof tests passed**, eight isolated memory processes, four Vite proof/library
builds and six Expo platform bundles. Two library-only lifecycle tests per
renderer were deliberately skipped by D7. This is scoped proof evidence, not a
full suite, lean gate, browser/native interaction test or production benchmark.
The final runtime source is recorded in the raw JSON; subsequent changes only
retain documentation and measurements.

The operator can drop the library requirement without giving up D1's demonstrated
isolation. Continue through the epic's effective-change contract and a bounded
production consumer before expanding scope. Preserve missing-row, deletion,
optimistic echo/rejection, atomic batch and owner-lifetime semantics there. The
finding does not authorize or perform that migration. MobX's automatic graph may
still be valuable in a materially more dynamic consumer, but this proof supplies
no evidence that its complexity or bytes are necessary for the measured topology.
