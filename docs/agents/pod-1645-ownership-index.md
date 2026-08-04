# POD-1645 — stop rebuilding the ownership index per session

Fixes the client-side freeze [POD-1641 profiled](pod-1641-client-freeze-profile.md).
Both of the stacked multipliers that report named are removed.

## What changed

**1. `worktreeForCwd` is a lookup, not a scan.**
`packages/model/src/identity/worktree.ts` gains `buildWorktreeRootIndex` +
`worktreeForCwdIndexed`: the roots go into a map keyed by normalized path, and a
cwd resolves by walking its own ancestors longest-first, returning on the first
hit. That is O(path depth) per session against O(roots) before, and the first
hit IS the longest match, so the scan's length comparison disappears with it.
`indexSessionOwnership` and the four other membership helpers in
`session-ownership.ts` build the index once per call instead of scanning per
session.

The linear `worktreeForCwd` stays exported: it is the ORACLE the parity test
grades the index against, and a handful of single-shot callers still use it.

**2. One replica delta publishes one snapshot.**
`ClientRuntime.batch()` coalesces every `apply` inside it into one merged patch,
one published snapshot and one pass of reactions. `publishReplica` wraps its
three recomputes in it, so a delta touching sessions, issues and projections
publishes once rather than three times — and every snapshot-keyed published
slice derives once rather than three times. The optimism ledger's own
multi-recompute paths (`recomputeAll`, `recomputeFor('issueProjections')`, the
spawn insert and its rollback) go through the same batch.

Coalescing is also the more honest reading of the event: the three writes come
from ONE delta, and no consumer should observe the intermediate state where
sessions have advanced but the issues they belong to have not.

## On memoising the index across deltas — deliberately NOT done

POD-1641's fix list led with "memoize the ownership index on
`(sessions, issues, allWorktreePaths)` identity". With the two changes above the
build costs ~3k map probes, so a cross-delta cache would buy a rounding error
and pay for it with an invalidation key — and a STALE ownership index
misattributes sessions to the wrong issue, which is worse than the freeze. The
worklist slice already memoises on snapshot identity, which is the correct key
and cannot go stale; adding a second cache under a second key is the exact shape
`publish.ts` warns about. Not worth it, and the numbers below are why.

## Measurements

### The count — the defect

`docs/agents/pod-1645/bench.mjs`, live dimensions (1100 sessions, 1600 issues,
111 worktrees ⇒ 1177 roots), driving the real functions from this checkout:

| per index build | comparisons / probes |
|---|---|
| scan (before) | **1,294,700** string comparisons |
| indexed (after) | **2,937** (1,177 build + 1,760 probes) — 441× fewer |

| per delta frame | |
|---|---|
| before | 3 builds = **3,884,100** comparisons |
| after | 1 build = **2,937** probes — **1,322× fewer** |

`parity: 0 disagreements across 1100 sessions` — the same run checks every
answer against the scan, because a faster wrong answer is not a fix.

### The profile — same instrument

V8 sampling profiler (what CDP `Profiler` samples), analysed with POD-1641's own
`docs/agents/pod-1641/cdpan.mjs`, over `docs/agents/pod-1645/bench.cpuprofile`
(3.5 s span). Both implementations run in the one profile, so this is a direct
before/after on identical input:

```
worktreeForCwd           1.915s  55.17% self     ← before
worktreeForCwdIndexed    0.002s   0.06% self     ← after
buildWorktreeRootIndex   0.019s   0.54% self     ← after, the one-time build
```

55.17% self time reproduces POD-1641's 54.1% on the live app almost exactly,
which is what makes the 0.60% next to it meaningful. Wall-clock for the same
pass, best of 3: **578 ms → 1.7 ms**; that number is colour only — this box ran
at load 47–79 throughout.

### The regression gate

`packages/client-core/src/engine/runtime.test.ts` — "one delta, one snapshot
(POD-1645)" asserts the CONSERVED QUANTITY (snapshots per delta), not a
duration. It can say NO: with the `batchDepth++` in `batch()` neutered, it
reports 3 and fails. Verified, both arms.

`packages/model/src/identity/worktree.test.ts` grades the index against the scan
on a table of the distinguishing cases plus 400 randomised corpora. It found a
real divergence during development (a trailing-slash root matching a cwd the
scan rejected), which is why `WorktreeRootEntry` carries both spellings.

### What was NOT re-run, and why

The end-to-end browser capture against the live corpus (`probe.mjs` / `cdp.mjs`
at `:18787`). Producing a comparable "after" needs a second server over a copy
of the live 219 MB database plus a web build, and this box has **1.1 GB free
(100% full)**; a truncated write there is silent corruption, and `~/.podium` is
live with the operator working in it. The freeze is a pure-CPU hot loop with no
network or storage component (POD-1641 exonerated both), so the profiler numbers
above measure the same quantity the browser capture would — but the end-to-end
"the app no longer freezes" observation is still owed, and is best taken on the
next deploy of this branch.
