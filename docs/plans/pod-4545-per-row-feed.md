# Round three L3a: the per-row kernel feed (POD-4553)

As of this issue's landing on `integrate/4545-round-three`. Counts only; no timings.

## What changed

The shared row source (`packages/worklist-proto/shared/src/row-source.ts`) no longer holds
per-kind Maps over the runtime's folded arrays. Each row it hands the prototypes is read by id:

```
value = foldRowOverlays(replica.row(kind, id), runtime.pendingOverlaysByRow(entity).get(id))
```

- `replica.row()` is the kernel facade's by-id read (`replica/contract.ts`, implemented in
  `replica/kernel/facade.ts`). The source now refuses to start without it and without the
  addressed-batch seam; the old kind-grained fallback is gone.
- `OptimismLedger.pendingByRow(entity)` (new, `engine/optimism.ts`) groups the ledger's pending
  overlays by row id. It is O(pending writes). `ClientRuntime.pendingOverlaysByRow` exposes it
  read-only.
- `ClientRuntime.pendingOverlaysByRow` is the one change to `runtime.ts`. It is a read-only
  pass-through and is disclosed on this issue. `enqueueOverlayed` is untouched.
- `foldRowOverlays` (new, `engine/overlay.ts`) is the ledger's fold rule for one row. A test in
  `overlay.test.ts` checks it against the whole-list `foldOverlays` row by row, for value and
  identity, over eight cases. Two planted mutations, dropping the "no cell moved" rule and dropping
  inserts, each fail it.
- With no overlay, the value is the replica's own row object. A rejection therefore restores the
  earlier object, and identity-based commit counting still works.

## Two modes, named by every consumer

The coordinator ruled after the L1c write contract landed. Every `createRowSource` call names
a mode, and there is no default:

- `overlaid` returns server truth with the ledger's pending overlays folded in, which is what
  the app paints today. It is for phase a/b pools and for parity with the legacy derivation.
  Every existing caller now passes `{ mode: 'overlaid' }`.
- `truth` returns server truth only. It never reads the ledger and does not subscribe to runtime
  publications. It is for phase c pools, which layer their own optimism on top
  (`write-contract.ts`). An overlay in that mode would hide a remote value for a field that is
  pending locally, and a rejection would rewind twice.

Both directions are asserted, per mode:

| test | overlaid | truth |
|---|---|---|
| fake runtime: press, then a remote value for the same pending field | press paints `Local`; remote stays masked as `Local` | press emits nothing; remote arrives as the replica object |
| real runtime `markIssueRead` | update, echo, rejection restores identity (existing test) | press emits nothing; the remote `readAt` arrives as the replica row |
| fence at 1x/4x | below | below |

Both directions of the switch were mutated. When `truth` reads the ledger, 3 tests fail: the
fake-runtime truth test, the real-runtime truth test and the truth fence. When `overlaid`
ignores the ledger, 5 tests fail, including the real-runtime rejection-identity test and the
overlaid fence.

## Which rows a flush reads

A flush reads the distinct slice rows that the kernel batch names, plus the rows that have
pending overlays now or had them at the previous flush. Addressed rows are always sent. A row
read only because of the ledger is sent only when its value changed from what the prototypes
already hold. For that reason a durable commit that repaints the press's own overlay sends
nothing.

A bootstrap or rescope `replace` enumerates the slice once. `snapshot()` is the only other
enumeration.

## Stats

`rebuilds` is removed. There are no per-kind indexes left to rebuild. The replacements:

| stat | meaning | expected |
|---|---|---|
| `rowsVisited` | slice rows resolved | addressed rows + pending-overlay rows, per flush |
| `enumerations` | whole-slice passes: replace, `snapshot()`, lane-index build | 0 except one per replace |
| `flushes` | drains that had a signal, whether or not they sent anything | — |

## Evidence

**Fence.** `row-source.test.ts`, test "visits exactly the addressed rows plus the pending-overlay
rows, equal at both scales". It uses the real runtime and kernel facade at the live-shaped sizes:
1x has 4,867 issues and 4,304 sessions, 4x has four times that. The test first asserts that the
replica and the runtime hold the whole corpus. The row source reads through counting wrappers:
every element read of any entity array it can reach, whether a runtime snapshot array or a
`replica.rows()` result, is counted.

| step | 1x visited / flushes | 4x visited / flushes | element reads (both scales) | rows emitted |
|---|---|---|---|---|
| heartbeat | 1 / 1 | 1 / 1 | 0 | 1 |
| rename (wire + projection) | 1 / 1 | 1 / 1 | 0 | 1 |
| dep edge + owner wire | 1 / 1 | 1 / 1 | 0 | 1 |
| burst of 50 | 50 / 1 | 50 / 1 | 0 | 50 |
| optimistic press (1 pending) | 2 / 2 | 2 / 2 | 0 | 1 |
| echo retires the overlay | 1 / 1 | 1 / 1 | 0 | 1 |
| heartbeat after settle | 1 / 1 | 1 / 1 | 0 | 1 |

That table is `overlaid`. In `truth` mode every kernel-addressed step is identical. The press
visits 0 rows and emits 0, and the echo visits 1 row and emits 1, at both scales.
`enumerations` is 0 on every step, in both modes, at both scales.

**Legacy control.** The same test was run against round two's row source (`git show
26efa5b90:packages/worklist-proto/shared/src/row-source.ts`). It fails at the first assertion,
`x1 heartbeat: no collection element read: expected 4304 to be +0`. Its element reads per step
grow with the corpus:

| step | 1x | 4x |
|---|---|---|
| heartbeat | 4,304 | 17,216 |
| rename | 9,734 | 38,936 |
| dep edge | 4,867 | 19,468 |
| burst of 50 | 4,304 | 17,216 |
| press / echo | 4,867 each | 19,468 each |

The control dimension, rows emitted per step, is identical in both versions.

**Every scenario.** `scenarios.test.ts`, "whole-slice passes happen only for a replace, once each",
runs on POD-4550's fixture at 1x. Enumerations are 0 on the 13 non-replace scenarios, 1 on
`principalSwitch`, and 2 on `rescopeGrowth`, which has 2 replaces. The live-scale heartbeat test
now asserts `enumerations == 0` at 1x, 2x and 4x.

**Behaviour kept.** These row-source tests pass unchanged: a press is an update of that row, the
echo is another, a rejection restores the earlier object itself, and a batch of 50 is one event.
The real-runtime test `markIssueRead paints an update, its echo another, a rejection restores the
prior identity` covers this. The full `@podium/worklist-proto` suite passes on this branch: 34 files,
257 tests.

**Mutants.** Two mutations were planted in the row source. Removing the identity retention fails
the optimistic test and the fence. Removing the "overlaid at the last flush" rows fails the
optimistic test and the real-runtime rejection test.

## Known divergences (documented, not silent)

- **Session resume twins.** The runtime hides all-parked legacy sessions that share a resume ref
  (`dedupeSessionsByResume`). That rule covers the whole kind, so a per-row feed cannot apply it
  without a resume-ref index. Such an index is a relation for the declared pool (POD-4546). The
  fixture has no resume refs by design.
- **Discovery lanes.** A new `EngineState.repos` array from discovery sends no worktree event.
  This behaviour is inherited from round two, because discovery is not a kernel row. A `repos`
  prefix address sends only that repo's lanes.

## For the arm builders

- `createRowSource(runtime, replica, { mode })` now takes a required mode: `'overlaid'` for
  phases a/b, `'truth'` for phase c.
- `RowSourceRuntime` now needs `pendingOverlaysByRow` and only `repos` from `getSnapshot()`.
  `ClientRuntime` already satisfies it.
- `ScenarioResult.stats.rebuilds` is now `enumerations`.
