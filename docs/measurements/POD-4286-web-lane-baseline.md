# POD-4286 web lane: baseline versus the integration branch

Run 2026-09-18 on ludovico, `bun run test:lane -- web` on both sides.

| Tree | Failing files | Failing tests | Total |
|---|---:|---:|---:|
| Clean detached checkout of the base `c5e5fdfaf` | 19 | 35 | 4131 |
| `integrate/4286-frontend-perf` at `6766e4183` | 20 | 37 | 4137 |

Difference, by file, computed with `comm` over the sorted `FAIL` lines of both runs:

- **Only in ours:** `src/perf/slice-render-count.test.tsx` (2 tests).
- **Only in the base:** none.

So Phase B introduced exactly one web-lane regression, and it is a test-only one.

## Re-run after B11 and B12 (same day)

The first comparison predates B11 (`6766e4183`), which changed product code in the
optimistic path, so the lane was re-run on `c728e9c25`:

| Tree | Failing files | Failing tests | Total |
|---|---:|---:|---:|
| Clean base `c5e5fdfaf` | 19 | 35 | 4131 |
| `integrate/4286-frontend-perf` at `c728e9c25` | 19 | 35 | 4137 |

Diffing the sorted `FAIL` file lists both ways is EMPTY in both directions: no file fails
only on ours, and none fails only on the base. **Phase B, complete, introduces zero web-lane
regressions.** The six extra passing tests are B12's repaired probe assertions.

## Why the one regression is not a product defect

`slice-render-count.test.tsx` deliberately publishes fresh snapshot objects carrying
identical slice-relevant content, because it was written when `slices/publish.ts` keyed on
snapshot IDENTITY. B5 (`82a1d1964`) gave `worklistSlice` a material-input guard, so an
identical-content snapshot is now correctly a cache hit and the slice derives nothing. The
probe's own armed guard — `expect(worklistDerivations()).toBeGreaterThan(atReady.worklist)`
— then fails with `expected 1 to be greater than 1`.

The probe is pinning a design we replaced, which is worse than having no probe: its ceiling
assertions would keep passing forever while measuring nothing. POD-4354 repairs it by making
each simulated publish carry a material change. Verified both directions: the file passes
2/2 on the clean base and fails 2/2 on the integration branch.

## The 19 baseline failures

They are pre-existing on this host and unrelated to this epic: `type-floor`, `IssuePage.*`,
the `test/*.structure.test.ts` files, `replica.test.ts`, several `features/setup` and
`features/settings` files, and others. They reproduce on a clean detached checkout of the
base with its own `setup:worktree` install, so they travel with the host and tree rather
than with any commit here.

**Method note.** "Pre-existing" was established by running the base in a SEPARATE clean
worktree, not by checking base files into the working tree. An environment failure is
invariant under the thing an A/B varies, so an in-tree comparison cannot see it.

## Branch verification summary

What has been checked on `integrate/4286-frontend-perf`, as of the Phase C gate:

| Check | Result |
|---|---|
| Web lane against a clean checkout of the base | Identical failures, 19 files / 35 tests both sides; the diff is empty in both directions |
| Scoped typecheck, `@podium/client-core` + `@podium/web` + `@podium/mobile` | 18 successful of 18 total; 4 executed rather than replayed from cache |
| Per-fix focused tests | Every landed fix re-run by the coordinator, not accepted on its author's report |
| Frontend perf lane | 28 tests across 5 files |
| Mobile lane | Both pre-existing failures repaired; the lane's two known reds are closed |
| History | Linear, no merge commits |
| Rebased onto current `dev/mw` | 35 commits replayed clean; our full diff byte-identical before and after (16,124 lines each); typecheck re-run green on the new base |

Three defects were caught by that re-verification that the authoring workers' own reports
had missed: a `TS2322` that shipped because a worker never claimed a typecheck, a test
asserting a mount flag the product had deliberately removed, and a render probe that one of
this epic's own fixes had silently turned into a no-op while still reporting green.

**Not claimed:** that the client is fast. The Phase C gate records a warm-switch p95 of
1,593.7 ms against a 100 ms target and an unrelated session event still costing one worklist
derivation. See `POD-4286-gate-a.md`.
