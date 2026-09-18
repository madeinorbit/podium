# Hand-written keyed store comparison

D7 extends [D1](4321-reactive-pilot.md) to answer whether the epic needs a reactive
library at all. This is a proof-only comparison; no production consumer, default
path, or dependency pin changes. D1's MobX-versus-TanStack decision is unchanged.

The third arm is [keyed.tsx](../../packages/client-core/proofs/d1/keyed.tsx): plain
immutable row Maps, per-address subscriber sets, lazy shared issue summaries and
React's existing `useSyncExternalStore`. Derived cells retain their last snapshot
and mark it dirty on material row/membership changes. Both summary consumers read
one cell. Unmount removes listeners; unobserved updates do no summary or mission
work; explicit owner disposal clears maps, caches and subscriptions.

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
delta (outside its timer), archived/presence changes, cross-family reassignment,
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
