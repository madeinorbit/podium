# One issue, one view object — the server echo stops rebuilding the project

Work for POD-1055, measured 2026-08-14 at the live Ludovico cardinalities
(1026 issues, 530 sessions). Picks up the one item POD-1053
(`docs/agents/pod-1053-issue-fanout.md`) measured and deliberately left behind.

## What was left

POD-1053 made the shared view-model cache incremental, and a one-field mutation's
OPTIMISTIC paint fell to one model (1.5 ms). But that reuse was gated on the
replica-derived snapshot standing still — which is true of an overlay fold and
of nothing else. The SERVER ECHO, the second half of every press, lands the same
values as truth, invalidates the snapshot, and

> `deriveIssueViewsSnapshot` re-derives every `IssueView` when a single issue row
> echoes back, so every model must be rebuilt (and then deep-compared back to its
> previous identity).

~27 ms per press, all of it spent proving nothing had changed.

## What changed

**1. `deriveIssueViews` preserves per-issue view identity.** Given the previous
pass's views, an issue whose derived value is equal keeps its OBJECT. The
derivation still runs whole — it is O(issues + sessions + deps) and stays that
way. What is saved is not the derivation, it is everything keyed on the identity
of what the derivation returns.

This is deliberately a re-derive-and-compare rather than a dependency graph. One
view's inputs are its own row, its children's stages, its deps' targets' stages,
every other issue's edges pointing at it, and its member sessions — a
neighbourhood wide enough that tracking it incrementally would rebuild the exact
cross-entity fan-out ADR 4 D7.2 exists to forbid. Comparing is linear in a pass
that was already linear.

**2. The model cache's reuse key is the model's inputs, not the snapshot's
identity.** `issue-view-cache.ts` now reuses a row's model when its projection,
its retained legacy row and its `IssueView` are all identity-unchanged — plus
the member sessions' ROWS, which `deriveIssueRollups` reads through the snapshot
for `phase` and `lastActiveAt`. A stable view fixes the member ID LIST and says
nothing about the sessions behind it, so those are compared over that one list.

The replica supplies the other half for free: `upsertRows` skips byte-identical
rows, so a re-applied snapshot leaves the 1025 untouched rows as the same
objects.

### Why this is safe under evict and rescope

The bar `viewmodels/slices/publish.ts` sets, and the reason POD-1053 stopped
short of this. Two properties, both structural:

- **`previous` is read BY ID, for the rows of the current pass, never
  enumerated.** The map returned is built only from the current iteration, so an
  issue the replica stopped sending is not looked up and has nothing that could
  put it back.
- **A reused object is one whose every field was just re-derived from current
  rows and matched.** Value equality is the reuse condition, so the only
  observable difference between reusing and rebuilding is the identity — which
  is the entire point. A previous generation belonging to another scope cannot
  leak a value in; it can only fail to match.

Both are pinned in `issue-views.test.ts` ("an issue that left the pass does not
come back", "a previous generation from ANOTHER world cannot leak a value into
this one") and at the cache layer in `issue-view-cache.test.ts` ("drops an issue
the replica stopped sending, however stable its view was").

## Measured

`apps/web/src/perf/tuck-fanout.probe.tsx` (POD-1053's diagnostic, unchanged):

```
bunx vitest run --root apps/web --config vitest.tuck-fanout-probe.config.ts
```

Medians of five runs per column on a shared host, so read the shape rather than
the last decimal. BEFORE is the same probe run in POD-1053's worktree — the code
that is now on `main`.

| per press (1026 issues / 530 sessions) | before | after |
| --- | ---: | ---: |
| optimistic paint — view models | 1.3 ms | 1.1 ms |
| optimistic paint — worklist derivation | 27 ms | 28 ms |
| server echo — view models | **29.8 ms** | **10.8 ms** |
| server echo — worklist derivation | 0.08 ms | 0.07 ms |
| **whole press** | **~61 ms** | **~39 ms** |

`issue-view-cache.test.ts` pins the mechanism rather than the millisecond: a
server echo that renames one issue now moves `rowBuilds` by 1, where it moved it
by the whole project before.

## What is left

**The remaining echo cost is the derivation itself, and that is the shape D7.3
asks for.** Broken down at these cardinalities: `readViewInputs` ~1.9 ms (it
re-joins 1026 `IssueViewInput`s from projections, repos and deps),
`deriveIssueViews` ~0.8 ms, `buildIssueTree` ~0.3 ms, `replica.rows()` ~1.1 ms,
and the cache's own reuse pass ~1.3 ms. Nothing here is a fan-out; it is one
linear pass over the world the client holds. Cutting it further means making the
replica-derived snapshot itself incremental, which is a different piece of work
with a different risk profile and no measured demand behind it yet.

**`IssueViewsSnapshot.tree` is built on every pass and has no production
reader** — `buildIssueTree` is called once, in `deriveIssueViewsSnapshot`, and
consumed only by tests. ~0.3 ms per pass. Left alone rather than made lazy
because the snapshot is spread (`{...snapshot, projectionRows, legacyRows}`),
which would evaluate a getter and buy nothing.

**This is still not the whole tuck-latency bug.** POD-1052 observes 1–2 s; this
and POD-1053 together account for ~130 ms of it. The rest needs a real-browser
profile and stays on POD-1052.
