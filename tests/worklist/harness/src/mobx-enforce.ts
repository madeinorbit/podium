/**
 * POD-4565 (Ma1) + POD-4760 + POD-4945 — MobX enforcement for the round-three
 * pool's tests. APPLIED ONLY IN TESTS (`mobx-trap.ts` configures it when a
 * pool suite installs the trap; ASSERTED by `pool.test.tsx`). Importing the
 * pool never configures MobX (MobX configuration is process-global), so
 * production pages keep the default flags. Moved from `arms/mobx/pool/`
 * (POD-4945): strict flags are test infrastructure, not product.
 *
 * - `enforceActions: 'always'`: every write is inside `runInAction` (one per
 *   `RowSourceEvent`, one per locals notification).
 * - `computedRequiresReaction` / `observableRequiresReaction`: a read outside
 *   a reaction or an action warns. The harness's out-of-reaction reader
 *   (the adapter's `tracked`) reads inside a transient reaction, so a warning
 *   always means a real untracked read.
 * - `reactionRequiresObservable`: a reaction that observes nothing warns.
 *
 * No `keepAlive` anywhere in `pool/`.
 */

export const ENFORCEMENT = {
  enforceActions: 'always',
  computedRequiresReaction: true,
  observableRequiresReaction: true,
  reactionRequiresObservable: true,
} as const
