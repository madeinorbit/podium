/**
 * POD-4565 (Ma1) + POD-4760 — MobX enforcement for the round-three pool,
 * APPLIED ONLY IN TESTS (`mobx-trap.ts` configures it when a pool suite
 * installs the trap; ASSERTED by `pool.test.tsx`). Importing the pool never
 * configures MobX, so production pages keep the default flags.
 *
 * - `enforceActions: 'always'`: every write is inside `runInAction` (one per
 *   `RowSourceEvent`, one per locals notification).
 * - `computedRequiresReaction` / `observableRequiresReaction`: a read outside
 *   a reaction or an action warns. The harness's out-of-reaction reader
 *   (the adapter's `tracked`) reads inside a transient reaction, so a warning
 *   always means a real untracked read.
 * - `reactionRequiresObservable`: a reaction that observes nothing warns.
 *
 * The round-two arm's `../config.ts` sets the same four flags; MobX
 * configuration is process-global, so the two agree by construction.
 * No `keepAlive` anywhere in `pool/`.
 */

export const ENFORCEMENT = {
  enforceActions: 'always',
  computedRequiresReaction: true,
  observableRequiresReaction: true,
  reactionRequiresObservable: true,
} as const
