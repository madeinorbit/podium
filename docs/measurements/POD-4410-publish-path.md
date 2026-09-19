# POD-4410 diagnosis: why the pilot publish path costs more than it saves

**Verdict: the pilot's per-publish cost is a full-corpus worklist rebuild on
every dirty read, at ~5x the legacy derivation it replaces — plus a
per-publish O(kind) index build. Neither `effective-changes` computation nor
`presentation.apply` dominates; the render-driven `readWorklist` does.**

## 1. The split that proves it (no-React probe, counts + walls)

A temporary probe (`pilot-publish-split.frontend-perf.tsx`, committed WIP on
this branch, deleted before landing) drives the real runtime directly — no
React — so the worklist cell stays dirty after a publish and a forced read
times exactly what F1's sync re-render was doing inside `storeMs`. Corpus:
`live` = 4,867 issues / 4,304 sessions, `ci` = 674 / 530. Lock discipline and
`uptime` per record as instructed; load was ~3.3 for these runs.

Per single session publish (`s2.lastActiveAt` bump), live:

| term | pilot | legacy |
|---|---|---|
| publish-only, no reads (kernel drain through runtime + effective publish + `presentation.apply`) | 14–23 ms | 5.5–6 ms |
| effective-view index builds in that window (counted via `measureEffectiveIndex`) | exactly 1: `sessions:4304` | 0 |
| forced worklist read right after (dirty cell) | **383–620 ms** | 84–116 ms (`worklistSlice` derive) |

Same shape at ci: publish-only 3–7 vs 1.5 ms; forced read 45–60 vs 4–9 ms.
Per publish-with-read the pilot is ~5x the legacy derivation **at both
scales** — linear in corpus (counts scale ~8–11x for 7.2x issues), not
superlinear. F1's steeper wall ratio is load contamination (its live arm ran
at loadavg 4–15 with another benchmark worker on the box); the counts are the
verdict and they scale with N.

Two consequences follow immediately:

- F1's "forced recompute is 0.01 ms, so the worklist is not the cost" was a
  misreading of *where* the cost lands, not whether it exists. With React
  mounted, the sync re-render derives the dirty cell inside the `storeMs`
  window (F1's own splits prove it: `reactMs` ~0.03 ms with `commits` = 1 —
  the commit happened inside `storeMs`), so the forced read hits a warm
  cache. The recompute happens; it just bills to `storeMs`.
- The "130–330 ms pilot-only path" is overwhelmingly the dirty worklist
  read, not the publish. Publish-only is 14–23 ms; the read is 383–620 ms.

## 2. The named code

`readWorklist()` (`packages/client-core/src/presentation/model.ts`) rebuilds
**all N** issue models on every dirty read — per-issue spreads, a 4,867-id
sort, sessions copy+sort, `sidebarSections`, `unifiedWorkList`,
`structure.place` — with **no `sourceEqual`/`isEqual` guard**. The legacy
`worklistSlice` it replaces has both (`sourceEqual` over named inputs,
per-snapshot `WeakMap` memo). Any invalidation — an unrelated session, a
selection change — rebuilds everything.

Inside that rebuild, the per-issue summaries go through `createComputedGraph`
(`presentation/computed.ts`) whose idle-ROOT LRU limit is **128 against
N = 4,867**. Every full pass churns ~4,739 roots through `remember`/`release`,
destroying the per-issue cache with its own limit, so the next read
recreates everything. Proof (summary-churn probe, no intervening change):

- ci: full summary pass 74 ms, immediate second pass 42 ms.
- live: full pass 409 ms, immediate second pass **1,093 ms**.

A working addressed cache would make the second pass ~free. The seed does
this three times over (36 index builds logged at construction+start: one per
replacement round × 12 kinds), which is the shape of the principal-switch
cost and an input to follow-up 2.

Candidate remedy (small, needs operator pricing, **not** applied here):
narrow the worklist cell's inputs so value-unchanged publications don't dirty
it (presentation `apply` already skips `===`-identical staged rows — extend
that value-equality to the cell-dirtiness decision, mirroring what the
computed graph's `sameValue` and the legacy issue-view-cache already do),
and/or raise/partition the computed-graph idle limit so one full pass does
not evict itself. Rough cost: days, not weeks — the `===` skip exists in one
place (`model.ts` apply loop) and the LRU limit is one constant, but the
invalidation-correctness proof (evict/rescope semantics) is the real work.
Deliberately out of scope here per the brief: no redesign of the
effective-changes contract on this issue.

## 3. The three F1 leftovers

**Navigation (332 ms for a local-keys-only publish).** Solved. The probe
measures navigation (`setSelectedIssueId`) at live: publish 2–6 ms with
**zero** index builds — and the forced worklist read after it 406–1,092 ms.
`selectedIssueId` is in `WORKLIST_INPUTS` (the selection latch), so a
local-only change dirties the worklist cell and the next read rebuilds the
whole corpus. "Strictly less input" was the wrong intuition: the cost was
never proportional to the input; it is one full rebuild per dirty flag.

**Burst 50-vs-18.** The premise is an instrument artifact, then a real gap.
Without React my probe shows **50 kernel batches → 50 store publishes in
both arms** (`dropped` 0/0): the legacy binding does not coalesce either.
F1's 18 comes from the stats instrument itself: `sessionById(sessions)`
calls `recordSliceDerivation(sessions, 'sessionById')` with the sessions
*array* as owner, so every legacy render mints a fresh id in the 32-slot
runtimes map; past 32 owners the runtime's own counters are evicted and
recount from zero mid-burst. Replication: legacy burst + one `sessionById`
per publish → **publishes 9, `dropped` 20**, at both scales (F1's exact
`dropped` signature; 9 vs 18 is just how many array-ids each render mints).
Single-publish scenarios are unaffected (too few owners to evict). The real
gap — neither arm coalesces a synchronous burst, because the kernel drains
per event at `batchDepth === 0` — is closable: wrapping the 50 upserts in
`replica.batch()` yields **1 kernel batch (50 rows) → 1 publish → 10 ms**
vs 295 ms unbatched at live, with the 50-row addressed batch flowing through
the existing multi-row `apply` loop. Cost to make it: route synchronous
multi-event drives through the facade's existing `batch()` — small and
localized; the addressed batch already carries all rows.

**Echo diverges 5x while rejection ties (same machinery).** Counts first:
publishes 6/6, wakes 30/30, selectors 24/24, commits 2/2, worklist-leaf
executions 2/2 — the machinery ran the *same number of times*. The content
differs. Echo has **two value-changing phases** per iteration (optimistic
paint + kernel confirm upsert); my per-phase splits time a full rebuild
after each (optimistic-forced 500–712 ms, confirm-forced 376–454 ms at
live). Rejection is **net-zero**: no kernel event, and the rollback restores
the exact row object (probe: `rowIdentityRestored: true`), while dead-letter
and discard publishes carry outbox-only keys that stage nothing in the
presentation model — so its renders observe a clean cell. That is the tie
vs the diverge. Residual, stated not smoothed: in isolation my probe shows
the optimistic paint dirties the cell in both modes, so the exact render
moment at which F1's rejection renders observed clean is React microtask
scheduling, untraceable from counters alone. It is bounded (leaf parity 2/2
plus forced-clean 0.005 ms) and remedy-independent: either way, cost accrues
only per dirty read, and only echo dirties twice per iteration.

## 4. Rerun vehicle

`bun run --cwd apps/web test:perf:large-state -- pilot-publish-split`
(ci ~10 s, live ~1 min for the split scenarios; all records are `[split]`
JSON with `uptime`+`loadavg`). The file is a WIP commit on this branch and
will be deleted before landing — it is evidence, not product.
