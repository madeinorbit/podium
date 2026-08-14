# One field, one row — removing the issue view-model fan-out

Work for POD-1053, measured 2026-08-14 at the live Ludovico cardinalities
(1026 issues, 530 sessions). Follows POD-1052's investigation
(`docs/agents/pod-1052-tuck-latency.md`), which named the cause; this is what
was done about it.

## The shape of the problem

Changing one field on one issue is an OVERLAY folded over server truth
(`engine/overlay.ts`), and the replica does not move at all. But the fold hands
the store a **new `issues` array** — the same row objects except the one it
patched — and two caches keyed on exactly that array identity, so both missed:

- `replica/use-issue-views.ts: modelsFor` rebuilt every issue view model in the
  project, then deep-compared each against the previous generation to recover
  row identity.
- `viewmodels/slices/worklist/published.ts: worklistSlice.sourceEqual` named
  `previous.issues === next.issues`, so `sidebarSections` + `unifiedWorkList` +
  `splitPinnedWork` + `groupUnifiedWorkRows` all re-ran over every issue and
  every session.

And `published.ts: issuesOf` called `issueViewModelsFromReplica` directly,
bypassing the memo `useReplicaIssues` had already filled for the same inputs —
so the whole build ran a second time, uncached, inside the derivation.

All of it twice per mutation: once for the optimistic paint, once for the server
echo that painted back the values already on screen.

## What changed

**1. The worklist reads the shared cache instead of rebuilding.** `issuesOf` now
calls `allIssueViewModels`, the imperative reader over the same memo the React
surfaces use. The memo moved out of `use-issue-views.ts` into a new React-free
`replica/issue-view-cache.ts`, because this slice is platform-neutral and mobile
derives it too; `use-issue-views.ts` is now the binding and nothing else.

**2. The rebuild is incremental.** `buildIssueViewModel` (singular) was split out
of the whole-map builder, which makes the dependency of one model explicit and
total: the snapshot, the row's projection, the row's retained legacy row. When
the snapshot is unchanged — which is the whole of the optimistic path, since the
replica never moved — a row whose two input objects are identity-unchanged
cannot have a different model, and the previous one is reused untouched. **A
one-row patch costs one model.**

This stays correct under evict and rescope, which is the bar
`viewmodels/slices/publish.ts` sets: the reuse decision is keyed on the identity
of inputs the CURRENT pass is holding, and the pass iterates the CURRENT rows. A
row that left the principal's slice is not in that iteration, so nothing can put
it back. The per-id memory is rewritten every pass, never accumulated.

**3. The worklist's dependency is the derived models, not the raw arrays.**
`sourceEqual` compares the model array identity (memoized per store snapshot in a
WeakMap, the key `publish.ts` argues is the safe one) instead of
`previous.issues`. This is a tightening: `derive` never reads `store.issues`, it
reads `issuesOf(store)`, and the models move whenever any visible cell of any
issue moves — including a row LEAVING, because a shrunken slice is a shorter
array and never an equal one. **This is what makes the server echo free.**

**4. The paint runs ahead of the durable commit.** `enqueueOverlayed` used to
await `outbox.enqueue` — an IndexedDB transaction on `Outbox.mutate`'s serial
chain — before folding anything. It now folds first. The number is small (the
network submit was already off that chain); the shape is the point.

Making that split free needed one more thing. The overlay is now minted ONCE, at
the press, and filed under the id the entry will carry — so the fold that runs
when the entry lands paints the same values, the models do not move, and the
worklist does not derive again. Re-projecting from the stored entry instead would
stamp a different clock on the five clock-stamped kinds (`issueSetTucked`,
`issueMarkRead`, `sessionMarkRead`, `issueDelete`, `issueUndefer`) and pay the
whole fan-out for a millisecond nobody can see. The id has to be minted by the
caller because the drain can fire `onApplied` before the enqueue's own promise
resolves — hence the new optional `mutationId` on `EngineOutbox.enqueue`.

**5. `foldOverlays` keeps row and array identity when a patch moves no cell.**
Cheap, and it makes the function's documented contract mean what it says. It does
not make an ordinary pending overlay identity-stable across recomputes — the base
it folds over is the replica's UNPAINTED row — and the comment says so.

## Measured

`apps/web/src/perf/tuck-fanout.probe.tsx` (throwaway diagnostic, not a CI gate):

```
bunx vitest run --root apps/web --config vitest.tuck-fanout-probe.config.ts
```

It drives the pipeline the app runs — the shared cache and the slice publisher —
rather than the three components in isolation, because that is where these fixes
live. The BEFORE column is a reconstruction in the same process on the same data:
the duplicate uncached build, the whole-project rebuild, and an unconditional
worklist derivation.

| per press (1026 issues / 530 sessions) | before | after |
| --- | ---: | ---: |
| optimistic paint — view models | ~18 ms (built twice) | **1.5 ms** |
| optimistic paint — worklist derivation | ~26 ms | 26.3 ms |
| server echo — view models | ~18 ms | 26.7 ms* |
| server echo — worklist derivation | ~26 ms | **0.07 ms** |
| **whole press** | **~161 ms** | **~55 ms** |

\* The echo's model cost did not fall, and the table is honest about it. See
below.

## What is left, and why it is not in this issue

> **Done, on POD-1055** — `docs/agents/pod-1055-issue-view-identity.md`. The
> derivation still runs whole; what changed is that it hands an unchanged issue
> back its previous `IssueView`, so the per-row reuse below applies to the echo
> too. Echo view models 29.8 ms → 10.8 ms; whole press ~61 ms → ~39 ms.

**The replica-derived snapshot is still rebuilt whole on any replica write.**
`deriveIssueViewsSnapshot` re-derives every `IssueView` when a single issue row
echoes back, so every model must be rebuilt (and then deep-compared back to its
previous identity). That is the ~27 ms in the echo row above, and it is now the
single largest remaining item on this path.

Fixing it means making `deriveIssueViews` preserve per-issue view identity, which
is a change to the D7.3 derivation itself rather than to its caches — a different
piece of work with a different risk profile. Filed as a discovered issue rather
than smuggled in here.

**This is still not the whole tuck-latency bug.** POD-1052 observes 1–2 s and
this accounts for ~106 ms of it. The rest is unexplained and needs a real-browser
profile; it stays on POD-1052.
