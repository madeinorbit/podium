# Pool memory breakdown (POD-5133, step 1)

**Measurement and report only; no product file changed.** Captured on flatblock,
2026-10-02 UTC, for the operator's decision on whether the app-wide MobX move
can meet the memory budget. The fix (step 2) waits for that decision.

## Summary

- **The extra memory is the pool's MobX bookkeeping, not extra copies of the
  data.** With the sidebar switch on, the browser keeps 33.6 / 122.6 / 72.9 MiB
  more V8 heap at 1× / 4× / 10× history (+113% / +134% / +73%). Removing the
  pool object, every MobX object and the pool's closures frees 87–93% of that
  difference: **6.4–7.2 KB per resident pool row** at 1× and 4×, 13.3 KB at 10×
  history, where rows that are not loaded are also tracked.
- **Where it goes, largest first (4×):** one MobX computed per issue per model
  field in `cached.ts` (46.7 MiB, ~2.6 KB per row); a tracking entry for every
  `ObservableMap` key a derivation looks up (19.5 MiB); a boxed value for every
  map entry (14.8 MiB); relation buckets (14.2 MiB); debug-name strings built for
  every per-row computed and reaction (8.3 MiB); one filing reaction per issue in `visible.ts`
  (7.2 MiB); residency's cold-row registry and summaries (5.5 MiB).
- **Row copies are small by comparison.** Today's app keeps three full copies of
  each issue: the old record and the projection in the kernel replica, plus the
  legacy view model, about 550 shallow bytes together. The pool adds one more, the
  temporary old-record join (212 bytes; 1.0 / 3.9 / 5.5 MiB). The pool's tables
  borrow the replica's row objects and copy nothing.
- **Deleting the legacy store does not fix it.** The legacy store's own per-row
  objects free only 2.7 / 10.6 / 15.2 MiB in the pool arm. The projected
  pool-only end state, with the legacy store deleted and POD-4949's one record,
  is still **+96% / +112% / +43%** over today's app.
- **What it would take.** In that end state, ≤10% leaves 4.9 / 13.9 / 17.9 MiB
  for the pool's reactive machinery once its plain indexes, residency and read
  state are counted: about **1.1 / 0.8 / 3.7 KB per resident row instead of
  7.2 / 6.4 / 13.3 KB**, a 4–8× cut. With both systems running (the pilot as it
  is now), the budget is 3.0 / 9.1 / 10.0 MiB, and the pool's parts that are not
  per-row MobX objects (indexes, groups, residency, read state and the temporary
  join: 3.3 / 13.1 / 20.1 MiB) already exceed it at every cell.

**Decision for the operator:** either redesign the pool's reactive layer so rows
that are not on screen carry no MobX objects, and hold the ≤10% target for the
end state (legacy store deleted, POD-4949 one record), or stop the app-wide move.
Meeting ≤10% while both systems run would additionally need residency summaries
and the temporary join to shrink; I do not recommend chasing that interim target.
The step-2 fixes and their measured sizes are under [What step 2 would change](#what-step-2-would-change).

## What was measured

| Property | Capture |
| --- | --- |
| Host / browser | flatblock; headless Chromium **153.0.8010.12** (Playwright build 1243), `LD_LIBRARY_PATH` to the private toolchain's `lib` |
| Product tree | integrate/4286-pilot **`0e031a48a8`** (dev/mw `721dd6937` plus later work). The capture commit `2cbd301a66` adds only measurement files; `git diff 0e031a48a8 2cbd301a66 -- packages apps/web/src` is empty |
| Build | One ordinary production Vite build of [the fixture](../../apps/web/test/pool-memory.browser.tsx) (no minification, no source maps, no timing hooks), served unchanged to both arms |
| Fixture | The POD-4959 memory cells: real `StoreProvider` runtime, kernel replica, IndexedDB adapter and outbox; production `SidebarUnified` plus its command palette; synthetic seed **4443**; clock anchored at 2026-09-20 noon; network disabled. No operator data |
| Switch | `mobxSidebar=0` (legacy) or `1` (pool), read once at startup in a fresh browser context; the mode guard refuses a wrong mode |
| Cells | 1× (4,867 issues), 4× (19,468 issues), 10× history with one unit of active work (27,601 issues) |
| Samples | 5 fresh contexts per arm and cell, arms interleaved with alternating first arm; V8 used heap after two forced collections 150 ms apart, following a 500 ms wait (POD-4959's statistic). The last context of each arm also took one heap snapshot |
| Load | flatblock load average 0.5–3.3 for every record; `bench:flatblock` held for the whole capture |

The five samples per arm agree to 0.1 MiB, so medians are reported. The
acceptance run's medians (29.0 / 62.6, 86.6 / 209.1, 93.1 / 166.0 MiB) were taken
on dev/mw `721dd6937` with ten samples; the pattern reproduces on the later tree.

integrate/4286-pilot moved to `49bd864068` ("Web issues read normalized
records") before this report landed. That tree was not measured on flatblock;
a one-sample smoke run of the same fixture on it, in this machine's older
Chromium, showed the same picture (31.2 vs 67.3 MiB at 1×, +116%).

### How memory is attributed

A heap snapshot is the whole live object graph. Attribution uses three
independent views, all from [heap-owners.ts](../../apps/web/harness/heap-owners.ts):

1. **Removal counterfactuals.** Block a chosen set of objects (named handles
   such as the pool or the published snapshot, every MobX object, objects with a
   given set of properties) and measure what is no longer reachable. This answers
   "what would removing this owner free". Cuts can overlap, so rows of T2 and T3
   do not add up.
2. **Creation sites.** Each MobX object is labelled by its debug name, or by the
   source line of its derivation; its listener sets, observer sets and
   name strings count with it. Closures are labelled by their source line and
   the bundle's `#region` source module.
3. **Row-copy census.** Every object whose `id` names a synthetic issue (or that
   carries a `sessionId`) is grouped by its exact property names, which shows
   how many copies of each row exist and in which shape.

Ownership by dominator tree (DevTools' "retained size") was also computed but
is not used for conclusions: the MobX graph links every observable to its
observers and back, and closures link to the global object, so nearly
everything is dominated by the root. Snapshot "live" totals include Blink's
native (DOM) objects and compiled code and therefore exceed V8 used heap; all
cuts free JavaScript heap objects only.

## Results

Tables below are generated by
`bun apps/web/harness/pool-memory-report.ts` from the capture's raw records
and analyses.

### T1. Retained heap, switch off vs on

| Cell | Samples per arm | Legacy V8 used | Pool V8 used | Difference | Regression | Snapshot live legacy | Snapshot live pool | Snapshot difference | Resident pool rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 5 / 5 | 29.8 | 63.4 | 33.6 | +113.0% | 44.2 | 78.9 | 34.7 | 4,746 |
| 4× | 5 / 5 | 91.3 | 213.9 | 122.6 | +134.3% | 122.7 | 246.4 | 123.7 | 18,801 |
| 10× history | 5 / 5 | 100.4 | 173.3 | 72.9 | +72.6% | 108.0 | 181.9 | 73.9 | 5,066 |

### T2. What the pool machinery holds (pool arm, removal counterfactuals, MiB)

Each row is measured alone; rows overlap and do not add. "All pool machinery" cuts the pool object, every MobX object and every closure from the pool chunks at once.

| Structure | 1× | 4× | 10× history | bytes / resident row 1× | bytes / resident row 4× | bytes / resident row 10× history |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Per-row model computeds (`cached.ts`) | 12.5 | 46.7 | 13.3 | 2,753 | 2,603 | 2,759 |
| Tracked key lookups (`ObservableMap.hasMap_`) | 5.3 | 19.5 | 5.8 | 1,169 | 1,090 | 1,202 |
| Boxed map entries (`ObservableMap` values) | 3.8 | 14.8 | 10.0 | 836 | 828 | 2,079 |
| Relation engine and buckets | 3.6 | 14.2 | 17.5 | 803 | 794 | 3,627 |
| Residency (cold-row registry, summaries) | 1.4 | 5.5 | 11.6 | 301 | 304 | 2,403 |
| MobX debug-name strings | 2.2 | 8.3 | 2.4 | 485 | 462 | 496 |
| Per-issue filing reactions (`visible.ts`) | 1.8 | 7.2 | 1.9 | 408 | 399 | 404 |
| Sidebar indexes and groups | 0.5 | 2.1 | 0.8 | 121 | 119 | 167 |
| Read-state lane | 0.4 | 1.6 | 2.2 | 90 | 91 | 458 |
| **All pool machinery** | **32.4** | **114.7** | **64.5** | **7,154** | **6,398** | **13,345** |
| Share of the snapshot difference | 93.3% | 92.8% | 87.2% |  |  |  |

### T3. Legacy-side owners in both arms (removal counterfactuals, MiB)

| Owner | 1× legacy | 1× pool | 4× legacy | 4× pool | 10× history legacy | 10× history pool |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy store: published snapshot, engine state, view models, mission index | 3.0 | 2.7 | 12.0 | 10.6 | 16.9 | 15.2 |
| Kernel replica and its cache (exclusive part) | 1.7 | 1.7 | 6.7 | 6.7 | 9.1 | 9.1 |
| Old issue record (one per issue) | 1.4 | 1.4 | 5.8 | 5.8 | 8.3 | 8.3 |
| Temporary old-record join (`temporary-issue-input.ts`) | 0.0 | 1.0 | 0.0 | 3.9 | 0.0 | 5.5 |

### T4. Projected pool-only end state (MiB, V8 used after GC)

Projection = pool arm V8 used minus what the cut frees in the pool arm; regression against today's legacy V8 used. End state A removes the legacy store; B also retires the temporary join and the old issue record (POD-4949), and adds back 64 bytes per issue for the fields the one record absorbs.

| Cell | Legacy today | Pool arm today | End state A | A regression | End state B | B regression | Pool machinery in B | Budget at +10% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 29.8 | 63.4 | 60.7 | +104.1% | 58.2 | +95.6% | 32.4 | 32.7 |
| 4× | 91.3 | 213.9 | 203.4 | +122.7% | 193.3 | +111.7% | 114.7 | 100.5 |
| 10× history | 100.4 | 173.3 | 158.1 | +57.5% | 144.0 | +43.4% | 64.5 | 110.5 |

### T5. Copies of each issue row (shallow bytes per copy; same in both arms unless marked)

1×:

| Copy | Objects (legacy arm) | Objects (pool arm) | Shallow bytes per copy (median shape) |
| --- | ---: | ---: | ---: |
| Legacy issue view model | 4,862 | 4,862 | 216 |
| Old issue record (replica) | 4,862 | 4,862 | 176 |
| Issue projection (replica) | 4,865 | 4,865 | 152 |
| Legacy published sorted-issue entry | 4,867 | 4,867 | 52 |
| Legacy issue-view entry | 4,867 | 4,867 | 52 |
| Temporary old-record join output (pool only) | 0 | 4,867 | 212 |
| Pool IssueModel (pool only) | 0 | 3,434 | 24 |

4×:

| Copy | Objects (legacy arm) | Objects (pool arm) | Shallow bytes per copy (median shape) |
| --- | ---: | ---: | ---: |
| Legacy issue view model | 19,448 | 19,448 | 216 |
| Old issue record (replica) | 19,448 | 19,448 | 176 |
| Issue projection (replica) | 19,460 | 19,460 | 152 |
| Legacy issue-view entry | 19,468 | 19,468 | 52 |
| Legacy published sorted-issue entry | 19,468 | 19,468 | 52 |
| Temporary old-record join output (pool only) | 0 | 19,468 | 212 |
| Pool IssueModel (pool only) | 0 | 13,320 | 24 |

### T6. Largest pool-only creation sites at 4× (pool minus legacy, MiB)

| Site (MobX object and debug name, or closure) | Source module of the closure | Objects | MiB |
| --- | ---: | ---: | ---: |
| `ObservableValue ObservableMap.key? (unobserve listeners)` |  | 0 | 10.27 |
| `ObservableValue ObservableMap.key?` |  | 64,124 | 9.27 |
| `ObservableValue ObservableMap.key` |  | 107,645 | 9.25 |
| `(MobX debug names)` |  | 0 | 8.27 |
| `ComputedValue IssueModel@*.presence` |  | 13,236 | 2.36 |
| `closure (anonymous)` | `packages/client-graph/src/cached.ts` | 86,884 | 2.32 |
| `ComputedValue IssueModel@*.nesting` |  | 11,979 | 2.12 |
| `ComputedValue IssueModel@*.presence (unobserve listeners)` |  | 0 | 2.07 |
| `ComputedValue IssueModel@*.facts` |  | 10,837 | 2.05 |
| `ComputedValue IssueModel@*.nesting (unobserve listeners)` |  | 0 | 1.87 |
| `ComputedValue IssueModel@*.facts (unobserve listeners)` |  | 0 | 1.69 |
| `ComputedValue IssueModel@*.members` |  | 6,741 | 1.27 |
| `ComputedValue SessionModel@*.retention` |  | 7,043 | 1.24 |
| `ComputedValue SessionModel@*.retention (unobserve listeners)` |  | 0 | 1.10 |
| `ComputedValue IssueModel@*.members (unobserve listeners)` |  | 0 | 1.05 |
| `ObservableArrayAdministration ` |  | 8,603 | 0.92 |
| `ComputedValue IssueModel@*.nestBelow` |  | 4,868 | 0.85 |
| `closure (anonymous)` | `mobx/dist/mobx.mjs` | 10,821 | 0.83 |
| `ComputedValue IssueModel@*.nestBelow (unobserve listeners)` |  | 0 | 0.76 |
| `Reaction pool.file.*` |  | 10,820 | 0.70 |
| `closure res` | `mobx/dist/mobx.mjs` | 10,821 | 0.66 |
| `ComputedValue IssueModel@*.unitsBelow` |  | 3,756 | 0.66 |
| `ComputedValue IssueModel@*.unitOwn` |  | 3,756 | 0.66 |
| `ObservableSet pool.issue.sessions.bucket` |  | 3,728 | 0.64 |
| `Atom pool.seats.bucket` |  | 8,550 | 0.59 |


## What step 2 would change

Each item names the measured structure, the mechanism found in the snapshot
and the source, and the change it points to. None of these is made here. All of
them keep the one row reader (`row(entity, id, absent)`), the residency rules
and the existing write path.

| # | Structure (4× size) | Mechanism | Change it points to |
| --- | ---: | --- | --- |
| 1 | Per-row model computeds, 46.7 MiB | `cachedGroup` (`cached.ts`) makes one MobX computed per object and group, each with a derivation closure, an unobserve listener set and closure, and a debug name. 13,236 `presence`, 11,979 `nesting`, 10,837 `facts`, 6,741 `members`, 7,043 session `retention` and more are alive at 4×. They stay alive because the sidebar's whole-list derivations read them for nearly every resident row, so "built only when read" does not save anything here | Compute per-row facts inside the whole-list derivations as plain values cached by input identity (the legacy `issue-view-cache` pattern), and keep MobX computeds only for rows a mounted component reads |
| 2 | Tracked key lookups, 19.5 MiB, and boxed map entries, 14.8 MiB | Pool tables, relation maps and the read-state lane are MobX `ObservableMap`s. MobX boxes every entry in its own observable value (107,645 at 4×), and `get(key)` inside a derivation first calls `has(key)`, which creates another observable value plus a listener set and closure for that key (64,124 at 4×) | Back tables with plain maps: one change signal per table for whole-list readers, and a per-key signal created only while a mounted reader observes that key, both behind the one row reader |
| 3 | Relation buckets, 14.2 MiB (17.5 MiB at 10× history) | One `ObservableSet` (signal, value enhancer closure, set) per relation bucket, including buckets that link cold rows | Plain sets with one change signal per relation; no per-bucket MobX objects for rows that are not resident (the "indexes over resident rows only" rule) |
| 4 | Debug-name strings, 8.3 MiB | `cached.ts` names every computed `<Class>@<id>.<group>` and `visible.ts` names every reaction `pool.file.<id>`, in production builds too. Each name is a fresh concatenated string | Build names only in development builds. The smallest change, and independent of the others |
| 5 | Filing reactions, 7.2 MiB | `visible.ts` starts one MobX `reaction` per issue (10,820 at 4×), each with its action wrapper, disposer and closures | One reaction over the set of filings, or derive filing where it is read |
| 6 | Residency, 5.5 MiB (11.6 MiB at 10× history) | The cold-row registry and per-row summaries | Out of scope for the MobX change; it dominates at 10× history and is the next target if the pilot state must meet the budget |
| 7 | Temporary old-record join, 3.9 MiB | One composed row per issue, kept in a WeakMap keyed by the projection | Retired by POD-4949; nothing to do before then |

Measured one at a time, items 1–3 and 5 free 102 MiB of the 114.7 MiB at 4×
(the cuts overlap, so their union is somewhat smaller). The
end-state target needs them reduced to about 0.8 KB per resident row in total,
so changing one item at a time cannot reach it; they share one cause (per-row
MobX objects for rows nobody looks at). Item 4 alone saves about 2.2 / 8.3 /
2.4 MiB and can ship separately.

## Limits

- One heap snapshot per arm and cell. The five V8 usage samples per arm agree
  to 0.1 MiB, and the snapshot came from the last of them.
- Counterfactuals measure what a cut frees in this snapshot. They do not predict
  a redesigned pool's footprint; the end-state rows in T4 are projections, with
  64 bytes per issue added back for the fields POD-4949's one record absorbs.
- "Legacy store" is defined by its handles (published snapshot, engine state and
  base arrays, view-model cache, mission index) and its per-issue shapes (view
  model, issue-view entry, sorted-issue entry). React state that holds legacy
  view models is cut through those shapes.
- Session rows have one copy in each arm (plus a 32-byte per-session facts
  entry in both). Census tables therefore list issue rows only.
- The fixture mounts the sidebar surface only, as POD-4959's memory cells did.
  Main panes would add the same objects to both arms.
- The capture ran from a bundled driver in `~/podium-test-5133` on flatblock,
  which links the dependencies and toolchain of `~/podium-timing` instead of a
  full checkout: flatblock had 1.2 GB (later 0.4 GB) free.

## Reproduction

```bash
bun apps/web/harness/pool-memory.ts --phase=build                       # once
bun build apps/web/harness/pool-memory.ts --target=bun --external @playwright/test \
  --outfile .artifacts/pool-memory/deploy/pool-memory.js               # driver bundle
# on flatblock, under a held bench:flatblock lease, from ~/podium-test-5133:
bun pool-memory.js --phase=capture --lease-confirmed --sha=<built SHA> --cells=1x --samples=5
bun apps/web/harness/pool-memory.ts --phase=analyze --out=capture      # per snapshot
bun apps/web/harness/pool-memory-report.ts                              # tables above
bun apps/web/harness/heap-owners-selftest.ts                            # analyzer checks
```

## Verification

- [The analyzer self-test](../../apps/web/harness/heap-owners-selftest.ts) runs
  16 checks on a hand-built snapshot with known answers. Seven planted mistakes
  each turned it red and it was green again after `cp` restoration: weak edges
  retaining, the owner holder retaining, the MobX cut ignored, string chunks
  lost at a chunk boundary, the absent-property rule ignored, the dominator
  taking the last predecessor, and debug names left unflattened.
- The capture's switch guard stopped the run (`Mode guard RED: expected legacy,
  got pool`) with `--plant-mode`, and passed without it.
- Biome reports no errors in the six new files; non-null-assertion warnings
  remain, as in the POD-4959 harness.
- **Not run:** the web project typecheck, which covers the new fixture. It runs
  on flatblock by rule and flatblock had no disk for a checkout. The fixture is
  built by Vite (which does not typecheck) and ran in every capture.

## Evidence

Issue artifacts on this issue (`podium issue artifact POD-5133`). The artifact
store caps a file at 100 MB, so the snapshot archive is split; `cat` the four
parts in order to rebuild it.

| Artifact under `.artifacts/pool-memory/` | Bytes | Contents |
| --- | ---: | --- |
| `pool-memory-evidence.tar.part-00` … `-03` | 352,634,880 in total | `capture/`: all six gzip heap snapshots, their meta files, `records.jsonl` (30 usage records), provenances and the six analyses |
| `pool-memory-analyses.tar.gz` | 536,698 | The same without the snapshots |

```text
pool-memory-evidence.tar (rebuilt)
c6fdacf3c232b61ae5e7b0e062fbd52c42a8e312f487274985b63d987ab8c9cc
pool-memory-analyses.tar.gz
a4ebcdd466cbb7428b22513166808fc5d614cf696c925e9428120e931675a8bc
```

The new collectors are [the driver](../../apps/web/harness/pool-memory.ts),
[the fixture](../../apps/web/test/pool-memory.browser.tsx),
[its build](../../apps/web/harness/pool-memory.vite.ts),
[the analyzer](../../apps/web/harness/heap-owners.ts) and
[the table generator](../../apps/web/harness/pool-memory-report.ts).
