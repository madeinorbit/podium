# POD-1641 — the client half of the multi-minute UI freeze

Measured against the live instance (`:18787`, real corpus) at
`ec2cf9928` (tip of `issue/279-integration`), 2026-08-04.

## Verdict

**The freeze is client-side, and it is not close.** The server contributes
seconds; the browser main thread burns minutes.

| | worst observed |
|---|---|
| server stall (its own `[podium:loop]` instrument, same window) | **1.1–1.6 s** |
| server HTTP latency sampled *during* a client freeze | **30 ms** |
| client main-thread block, first paint | **330 s** |
| client main-thread block, idle after paint, zero interaction | **116.5 s** |

POD-1638's three named queries are real, but they are not this. A 150-second
freeze is not a pile-up of 1.6-second server stalls — it is one client-side
hot loop, and the profile names it exactly.

## The profile

Firefox could not deliver one: the Gecko profiler only flushes on a clean
shutdown, and a content process wedged in JS never services the shutdown-dump
request, so every frozen run lost its buffer. Chromium + CDP `Profiler` samples
from the browser process and needs no cooperation from the page, so that is
what produced the numbers below. (The brief's note that headless Chromium
"dies ~3s into the authenticated app" did not reproduce here — it survives fine
when the driver script never issues a blocking `page.evaluate`.)

`cdp.cpuprofile` — 159,910 samples over a 222.7 s window spanning the freeze,
1 ms sampling interval.

### Top self time

Aggregated per function over the 222.7 s window:

```
  120.52s  54.1%  worktreeForCwd         (packages/model/src/identity/worktree.ts:5)
    8.75s   3.9%  buildUnifiedRows       (viewmodels/slices/worklist/rows.ts:39)
    7.66s   3.4%  (garbage collector)
    6.45s   2.9%  sidebarSections        (viewmodels/slices/worklist/nav.ts:62)
    6.13s   2.8%  indexSessionOwnership  (viewmodels/session-ownership.ts:126)
    3.49s   1.6%  sortUnifiedWorkRows    (viewmodels/slices/worklist/rows.ts)
```

One function — `worktreeForCwd` — is more than half the entire freeze, and
every other entry in the top six is on the same worklist-derivation path.

### Top inclusive

```
  207.5s  93.2%  onKernelEvent          ← one replica delta
  188.2s  84.5%  publishReplica
   70.2s  31.5%    recomputeIssueProjections
   69.4s  31.2%    recomputeIssues
   ~11s    5.0%    recomputeSessions
```

### The chain, leaf → root (the 45.6 s node, one of nine)

```
worktreeForCwd
indexSessionOwnership            session-ownership.ts:150
sidebarSections                  worklist/nav.ts:62
derive (worklist slice)          worklist/published.ts:130
publish → apply → publish
recomputeIssues                  ← and recomputeIssueProjections, and recomputeSessions
publishReplica
onKernelEvent
```

## Root cause

Two independent multipliers stack on the replica delta path.

**1. `indexSessionOwnership` is not an index — it is a nested scan.**
`session-ownership.ts:150` calls `worktreeForCwd(session.cwd, roots)` once per
session, and `worktreeForCwd` (`worktree.ts:5-12`) is a linear scan with a
`startsWith` per root. `roots` is not the 111 real worktree paths — it is
`allWorktreePaths ∪ every issue's worktreePath` (`session-ownership.ts:131-136`),
so it grows with the **issue count** (thousands on this corpus). Cost is
`O(sessions × (worktrees + issues))` string comparisons every time the index is
built.

Note this is the *builder* of the ownership index that POD-1618 introduced to
remove per-session lookups. The consumers were memoized; the builder itself was
not, and it is now the hot spot.

**2. `publishReplica` rebuilds it up to three times per delta.**
`publishReplica` fans a single kernel event into `recomputeSessions()`,
`recomputeIssues()` and `recomputeIssueProjections()`. Each one calls `publish`,
each `publish` synchronously re-runs the `worklist` slice's `derive`, and each
`derive` calls `sidebarSections` → `indexSessionOwnership` from scratch. Three
full O(sessions × issues) passes per delta, with nothing cached between them —
the profile shows the same stack at three sibling depths.

Multiply by the delta volume of a cold sync (the server answered one
`changesSince` with 9,352 rows) and 200+ seconds of blocking is exactly what
falls out.

## What this rules out

Of the brief's four candidate shapes, the profile confirms one and clears three:

- **render pass over the full list per delta frame** — confirmed, but it is the
  *slice derivation*, not React. React's `beginWork`/`renderRootSync` are
  visible only in the fast-load control profile and are a rounding error here.
- **per-row effect re-subscription** — not present.
- **synchronous IndexedDB write-through** — not present. The replica is
  localStorage-backed, and neither `Storage.setItem` nor `JSON.stringify`
  appears in the top frames. (The `replica.ts:30` "per-delta persistence
  rewrites each touched collection blob whole — acceptable at current sizes"
  comment is a plausible-looking suspect that the profile exonerates.)
- **request amplification per scroll tick** — not present; 19 fetches total
  across a full session, and the server answered in 30 ms throughout.

## Reproduction

`page.evaluate(() => 1 + 1)` as a main-thread availability probe, Firefox with a
`podium_session` cookie:

```
[idle-baseline]  n=2  p50=52289ms  max=52289ms     ← no interaction at all
[idle]           n=2  p50=116515ms max=116515ms    ← after first paint
READY 32698 chars at 330250 ms                     ← first paint
```

An in-page `setInterval` gap detector agreed: a single 145,969 ms gap, 239 s of
total blocked time across the run. Zero console errors, matching the brief —
nothing throws, it is pure blocking work.

Scripts: `probe.mjs` (stall detector + request census), `cdp.mjs` (CDP profile
capture), `cdpan.mjs` / `chain.mjs` (analysis).

## The fix, in order of leverage

1. **Memoize the ownership index** on `(sessions, issues, allWorktreePaths)`
   identity so three recomputes in one delta share one build. Cheapest change,
   removes ~2/3 of the cost immediately.
2. **Make `worktreeForCwd` non-linear.** Longest-prefix containment over a fixed
   root set is a trie or a path-segment map walk, not an N-scan per session.
   Removes the remaining multiplier.
3. **Coalesce `publishReplica`.** One publish per kernel event rather than one
   per recompute family; batch the delta flood so a cold sync does not derive
   per row.

(1) and (2) are independent and both worth doing; (3) is the structural one.
