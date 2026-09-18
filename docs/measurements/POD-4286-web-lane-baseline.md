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
